import type { ExecutorInput, ExecutorOutput, ScriptExecutor, ScriptExecutorError } from "./types";

type CappedText = { text: string; truncated: boolean };

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

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<CappedText> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = maxBytes - total;
    if (remaining > 0) {
      const accepted = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(accepted);
      total += accepted.byteLength;
    }
    if (value.byteLength > remaining) truncated = true;
  }

  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

function classifyExit(
  exitCode: number,
  timedOut: boolean,
  killed: boolean,
): ScriptExecutorError | undefined {
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

function harnessCommand(harnessPath: string, input: ExecutorInput): string[] {
  if (process.platform === "win32") {
    return ["bun", "run", harnessPath];
  }

  // Bun's Linux runtime reserves several GB of virtual address space at startup.
  // A lower RLIMIT_AS kills the harness before user code runs, so keep vmem as
  // a coarse guard and rely on the tighter CPU/proc/fd/file/output caps for v1.
  const virtualMemoryMb = Math.max(input.resources.memoryMb, 4096);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const ulimits = [
    `ulimit -v ${Math.floor(virtualMemoryMb * 1024)} 2>/dev/null || true`,
    `ulimit -t ${input.resources.cpuTimeSec} 2>/dev/null || true`,
    `ulimit -u ${input.resources.maxProcs} 2>/dev/null || true`,
    `ulimit -f ${Math.floor(input.resources.maxFileBytes / 1024)} 2>/dev/null || true`,
    `ulimit -n ${input.resources.maxFdCount} 2>/dev/null || true`,
  ].join("; ");
  const harness = shellQuote(harnessPath);
  return [
    "sh",
    "-c",
    `${ulimits}; exec env -i PATH="$PATH" HOME="$HOME" LANG="$LANG" LC_ALL="$LC_ALL" TMPDIR="$TMPDIR" SWARM_SCRIPT_TMPDIR="$SWARM_SCRIPT_TMPDIR" SWARM_SCRIPT_ARGS_FILE="$SWARM_SCRIPT_ARGS_FILE" SWARM_SCRIPT_SOURCE_FILE="$SWARM_SCRIPT_SOURCE_FILE" SWARM_SCRIPT_RESULT_FILE="$SWARM_SCRIPT_RESULT_FILE" SWARM_SCRIPT_ERROR_FILE="$SWARM_SCRIPT_ERROR_FILE" bun run ${harness}`,
  ];
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
    // In compiled binary mode, import.meta.url points into /$bunfs/ which spawned
    // subprocesses cannot access. Use the pre-built bundle from real filesystem instead.
    const harnessPath = process.env.SCRIPT_RUNTIME_DIR
      ? `${process.env.SCRIPT_RUNTIME_DIR}/eval-harness.bundle.js`
      : new URL("../eval-harness.ts", import.meta.url).pathname;
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

      const proc = Bun.spawn(harnessCommand(harnessPath, input), {
        env: {
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
        },
        cwd: tmpdir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      });

      proc.stdin.write(JSON.stringify(input.configPayload));
      proc.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(proc.stdout, input.resources.maxStdoutBytes),
        readCapped(proc.stderr, input.resources.maxStdoutBytes),
        proc.exited.catch(() => (timedOut ? 124 : 1)),
      ]).finally(() => clearTimeout(timeout));

      const result = exitCode === 0 ? await readResultFile(resultFile) : undefined;
      const runtimeError = exitCode === 0 ? undefined : await readRuntimeError(errorFile);
      const error = classifyExit(exitCode, timedOut, killed);

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
