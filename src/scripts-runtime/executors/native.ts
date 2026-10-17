import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detachedProcessGroup,
  registerProcessGroup,
  terminateProcessGroup,
} from "../../utils/process-group";
import { chownForSandbox, leaseSandboxUid, type SandboxUidLease } from "../../utils/sandbox-uid";
import {
  buildSandboxedCommand,
  readStreamCapped,
  type SandboxSpawnOptions,
  sandboxSpawnEnv,
} from "../../utils/sandboxed-process";
import {
  interpretSandboxProbe,
  nativeSeccompPolicy,
  requireNativeIsolation,
  type ScriptSandboxStatus,
  sandboxProbeInput,
} from "../sandbox-probe";
import type { SeccompPolicy } from "../sandbox-seccomp";
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

export async function writeBareImportShim(
  tmpdir: string,
  name: string,
  targetUrl: URL,
): Promise<void> {
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
      ["zod/mini", `${runtimeDir}/zod-mini.bundle.js`],
    ];
    for (const [name, bundlePath] of shims) {
      const dir = `${tmpdir}/node_modules/${name}`;
      await Bun.$`mkdir -p ${dir}`;
      await Bun.write(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.js" }));
      await Bun.write(
        `${dir}/index.js`,
        `export * from ${JSON.stringify(pathToFileURL(bundlePath).href)};\n`,
      );
    }
    return;
  }
  await writeBareImportShim(tmpdir, "stdlib", new URL("../stdlib/index.ts", import.meta.url));
  await writeBareImportShim(tmpdir, "swarm-sdk", new URL("../swarm-sdk.ts", import.meta.url));
  for (const name of ["zod", "zod/mini"]) {
    await writeBareImportShim(tmpdir, name, pathToFileURL(Bun.resolveSync(name, import.meta.dir)));
  }
}

function harnessCommand(
  harnessPath: string,
  input: ExecutorInput,
  env: Record<string, string>,
  options: SandboxSpawnOptions,
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
    options,
  );
}

let sandboxStatus: ScriptSandboxStatus | undefined;
let sandboxStatusPromise: Promise<ScriptSandboxStatus> | undefined;
let probedPolicy: SeccompPolicy | undefined;

/**
 * Run the sandbox probe once per process and exec-deny policy (see
 * `sandbox-probe.ts`). The API starts it at boot; `SCRIPT_NATIVE_REQUIRE_ISOLATION`
 * runs await it. Changing `SCRIPT_NATIVE_EXEC_DENY` at runtime re-runs it.
 */
export function getNativeSandboxStatus(): Promise<ScriptSandboxStatus> {
  const policy = nativeSeccompPolicy();
  if (sandboxStatusPromise && probedPolicy === policy) return sandboxStatusPromise;
  probedPolicy = policy;
  sandboxStatus = undefined;
  const probe: Promise<ScriptSandboxStatus> = new NativeScriptExecutor()
    .runUnchecked(sandboxProbeInput())
    .then((output) => interpretSandboxProbe(output, process.getuid?.()))
    .catch((error: unknown) => ({
      level: "none" as const,
      uidDropped: false,
      seccomp: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((status) => {
      // A newer probe for another policy owns the cache now.
      if (sandboxStatusPromise === probe) sandboxStatus = status;
      return status;
    });
  sandboxStatusPromise = probe;
  return probe;
}

/**
 * The probe result for the current exec-deny policy, or `undefined` while it
 * has not finished. A policy change since the last probe starts a new one.
 */
export function peekNativeSandboxStatus(): ScriptSandboxStatus | undefined {
  if (probedPolicy !== undefined && probedPolicy !== nativeSeccompPolicy()) {
    void getNativeSandboxStatus();
  }
  return sandboxStatus;
}

export class NativeScriptExecutor implements ScriptExecutor {
  readonly name = "native";

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (requireNativeIsolation()) {
      const status = await getNativeSandboxStatus();
      if (status.level !== "hardened") {
        return makeUnsupportedOutput(
          `SCRIPT_NATIVE_REQUIRE_ISOLATION is set, but the native script sandbox is "${status.level}", not "hardened". The API must run as root with the CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID and SETUID capabilities, and the seccomp filter must install${nativeSeccompPolicy() === "off" ? ", but SCRIPT_NATIVE_EXEC_DENY=false turns it off; to run scripts without the filter, turn SCRIPT_NATIVE_REQUIRE_ISOLATION off too" : ""}.`,
        );
      }
    }
    return this.runUnchecked(input);
  }

  /** `run` without the isolation requirement; the sandbox probe uses it directly. */
  async runUnchecked(input: ExecutorInput): Promise<ExecutorOutput> {
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
    let timedOut = false;
    let killed = input.signal?.aborted ?? false;
    let removeAbortListener: (() => void) | undefined;
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    let uidLease: SandboxUidLease | null = null;

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
        if (proc) void terminateProcessGroup(proc.pid);
      };
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", onExternalAbort);

      // An abort before the listener existed fires no event; check it here.
      if (input.signal?.aborted) killed = true;
      if (killed) throw new Error("script run aborted before start");
      uidLease = await leaseSandboxUid(input.signal);
      if (uidLease) await chownForSandbox(tmpdir, uidLease.user);
      // Lease and chown are async: the listener may have fired with no child
      // to terminate. Never spawn after an abort; `finally` releases the lease.
      if (killed) throw new Error("script run aborted before start");

      const timeout = setTimeout(() => {
        timedOut = true;
        if (proc) void terminateProcessGroup(proc.pid);
      }, input.resources.wallClockMs);

      const harnessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // The API's own HOME is not readable by a sandbox uid.
        HOME: uidLease ? tmpdir : (process.env.HOME ?? "/tmp"),
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        TMPDIR: tmpdir,
        SWARM_SCRIPT_SECCOMP: nativeSeccompPolicy(),
        SWARM_SCRIPT_TMPDIR: tmpdir,
        SWARM_SCRIPT_ARGS_FILE: argsFile,
        SWARM_SCRIPT_SOURCE_FILE: sourceFile,
        SWARM_SCRIPT_RESULT_FILE: resultFile,
        SWARM_SCRIPT_ERROR_FILE: errorFile,
        SWARM_SCRIPT_STARTED_FILE: startedFile,
      };

      proc = registerProcessGroup(
        Bun.spawn(harnessCommand(harnessPath, input, harnessEnv, { user: uidLease?.user }), {
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
      if (proc) await terminateProcessGroup(proc.pid);
      await uidLease?.release();
      await Bun.$`rm -rf ${tmpdir}`;
    }
  }
}
