import { fileURLToPath } from "node:url";
import {
  buildSandboxedCommand,
  readStreamCapped,
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
 * `input.signal` abort) kill the child via `AbortController` -> `Bun.spawn`'s
 * default signal, which is SIGTERM (exit 143) — never SIGABRT (134, signal
 * 6). So an observed 134 can only be the process's own abort; it did not
 * come from us. Under CI load the watchdog can still fire in the same window
 * as a genuine self-abort (`setTimeout` is a macrotask racing `proc.exited`'s
 * resolution), which flips `timedOut` true even though the process had
 * already exited on its own — trusting that flag over the exit code
 * misclassifies a real `capacity_exceeded`/`eval_error` as `timeout`.
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

async function readResultFile(path: string): Promise<unknown | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  if (!text) return undefined;
  return JSON.parse(text);
}

async function readRuntimeError(
  path: string,
): Promise<import("./types").ScriptRuntimeError | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as import("./types").ScriptRuntimeError;
  } catch {
    return undefined;
  }
}

async function writeBareImportShim(tmpdir: string, name: string, targetUrl: URL): Promise<void> {
  const dir = `${tmpdir}/node_modules/${name}`;
  await Bun.$`mkdir -p ${dir}`;
  await Bun.write(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.ts" }));
  await Bun.write(`${dir}/index.ts`, `export * from ${JSON.stringify(targetUrl.href)};\n`);
}

async function writeBareImportShims(tmpdir: string): Promise<void> {
  const runtimeDir = process.env.SCRIPT_RUNTIME_DIR;
  if (runtimeDir) {
    // Compiled binary mode: use pre-built bundles on real filesystem.
    // import.meta.url resolves to /$bunfs/ which spawned subprocesses can't access.
    const shims: [string, string][] = [
      ["stdlib", `${runtimeDir}/stdlib.bundle.js`],
      ["swarm-sdk", `${runtimeDir}/swarm-sdk.bundle.js`],
      ["zod", `${runtimeDir}/zod.bundle.js`],
    ];
    for (const [name, bundlePath] of shims) {
      const dir = `${tmpdir}/node_modules/${name}`;
      await Bun.$`mkdir -p ${dir}`;
      await Bun.write(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.js" }));
      await Bun.write(
        `${dir}/index.js`,
        `export * from ${JSON.stringify(`file://${bundlePath}`)};\n`,
      );
    }
    return;
  }
  await writeBareImportShim(tmpdir, "stdlib", new URL("../stdlib/index.ts", import.meta.url));
  await writeBareImportShim(tmpdir, "swarm-sdk", new URL("../swarm-sdk.ts", import.meta.url));
  // Allow `import { z } from "zod"` in user scripts (for argsSchema definitions).
  const zodEntry = Bun.resolveSync("zod", import.meta.dir);
  await writeBareImportShim(tmpdir, "zod", new URL(`file://${zodEntry}`));
}

function harnessCommand(
  harnessPath: string,
  input: ExecutorInput,
  env: Record<string, string>,
): string[] {
  return buildSandboxedCommand(["bun", "run", harnessPath], env, {
    virtualMemoryMb: input.resources.memoryMb,
    cpuTimeSec: input.resources.cpuTimeSec,
    maxProcs: input.resources.maxProcs,
    maxFileKb: Math.floor(input.resources.maxFileBytes / 1024),
    maxFdCount: input.resources.maxFdCount,
  });
}

export class NativeScriptExecutor implements ScriptExecutor {
  readonly name = "native";

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (input.fsMode === "workspace-rw") {
      return makeUnsupportedOutput("workspace-rw not supported by native executor in v1");
    }

    const start = Date.now();
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/swarm-script-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;

    const argsFile = `${tmpdir}/args.json`;
    const sourceFile = `${tmpdir}/source.ts`;
    const resultFile = `${tmpdir}/result.json`;
    const errorFile = `${tmpdir}/error.json`;
    const startedFile = `${tmpdir}/started.marker`;
    // In compiled binary mode, import.meta.url points into /$bunfs/ which spawned
    // subprocesses cannot access. Use the pre-built bundle from real filesystem instead.
    const harnessPath = process.env.SCRIPT_RUNTIME_DIR
      ? `${process.env.SCRIPT_RUNTIME_DIR}/eval-harness.bundle.js`
      : fileURLToPath(new URL("../eval-harness.ts", import.meta.url));
    const controller = new AbortController();
    let timedOut = false;
    let killed = input.signal?.aborted ?? false;
    let removeAbortListener: (() => void) | undefined;

    try {
      if (killed) {
        return {
          result: undefined,
          stdout: "",
          stderr: "",
          truncated: { stdout: false, stderr: false },
          durationMs: Date.now() - start,
          exitCode: 1,
          error: "killed",
        };
      }

      await Bun.write(argsFile, JSON.stringify(input.args ?? null));
      await Bun.write(sourceFile, input.source);
      await writeBareImportShims(tmpdir);

      const onExternalAbort = () => {
        killed = true;
        controller.abort();
      };
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", onExternalAbort);

      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, input.resources.wallClockMs);

      const harnessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        TMPDIR: tmpdir,
        SWARM_SCRIPT_TMPDIR: tmpdir,
        SWARM_SCRIPT_ARGS_FILE: argsFile,
        SWARM_SCRIPT_SOURCE_FILE: sourceFile,
        SWARM_SCRIPT_RESULT_FILE: resultFile,
        SWARM_SCRIPT_ERROR_FILE: errorFile,
        SWARM_SCRIPT_STARTED_FILE: startedFile,
      };

      const proc = Bun.spawn(harnessCommand(harnessPath, input, harnessEnv), {
        // On POSIX, Bun.spawn only needs PATH itself to locate the `sh`
        // binary for argv[0] — the sandboxed command's `env -i` prelude is
        // what actually scrubs the child's environment down to `harnessEnv`
        // above. On win32 there is no such prelude, so `sandboxSpawnEnv`
        // passes `harnessEnv` through directly instead — see
        // `buildSandboxedCommand`'s win32 doc comment.
        env: sandboxSpawnEnv(harnessEnv),
        cwd: tmpdir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      });

      proc.stdin.write(JSON.stringify(input.configPayload));
      proc.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        readStreamCapped(proc.stdout, input.resources.maxStdoutBytes),
        readStreamCapped(proc.stderr, input.resources.maxStdoutBytes),
        proc.exited.catch(() => (timedOut ? 124 : 1)),
      ]).finally(() => clearTimeout(timeout));

      const result = exitCode === 0 ? await readResultFile(resultFile) : undefined;
      const runtimeError = exitCode === 0 ? undefined : await readRuntimeError(errorFile);
      const userCodeStarted = await Bun.file(startedFile).exists();
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
      await Bun.$`rm -rf ${tmpdir}`;
    }
  }
}
