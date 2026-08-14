import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptRun } from "../types";
import {
  buildSandboxedCommand,
  readStreamCapped,
  sandboxSpawnEnv,
} from "../utils/sandboxed-process";
import { scriptRunMaxWallMs } from "./limits";

/** Matches the inline scripts-runtime cap (src/scripts-runtime/executors/types.ts). */
const MAX_STDERR_BYTES = 1_048_576;

export type ScriptExecutionResult = {
  exitCode: number | null;
  stderr: string;
};

export type ScriptExecutionHandle = {
  pid: number | null;
  tmpdir: string;
  startedAtMs: number;
  exited: Promise<ScriptExecutionResult>;
  terminate(signal?: NodeJS.Signals): void;
  cleanup(): Promise<void>;
};

export type StartScriptExecutionInput = {
  run: ScriptRun;
  baseUrl: string;
  apiKey: string;
};

export interface ScriptExecutor {
  start(input: StartScriptExecutionInput): Promise<ScriptExecutionHandle>;
  isRunning(pid: number): boolean;
  terminatePid(pid: number, signal?: NodeJS.Signals): void;
}

export function getScriptWorkflowHarnessPath(): string {
  const runtimeDir = process.env.SCRIPT_WORKFLOW_RUNTIME_DIR;
  if (!runtimeDir) return fileURLToPath(new URL("./harness.ts", import.meta.url));

  const bundledHarness = `${resolve(runtimeDir)}/harness.bundle.js`;
  if (!existsSync(bundledHarness)) {
    throw new Error(
      `Script workflow harness bundle not found at ${bundledHarness}. ` +
        "Build/copy harness.bundle.js and set SCRIPT_WORKFLOW_RUNTIME_DIR to its directory.",
    );
  }
  return bundledHarness;
}

export class LocalProcessScriptExecutor implements ScriptExecutor {
  async start(input: StartScriptExecutionInput): Promise<ScriptExecutionHandle> {
    const { run, baseUrl, apiKey } = input;
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-workflow-${run.id}`;
    await mkdir(tmpdir, { recursive: true });
    const sourceFile = `${tmpdir}/source.ts`;
    const argsFile = `${tmpdir}/args.json`;
    await Bun.write(sourceFile, run.source);
    await Bun.write(argsFile, JSON.stringify(run.args ?? null));

    // Non-secret env for the harness process. The bearer travels over stdin
    // instead (see below) — the harness dynamically `import()`s the user's
    // module INTO THIS SAME PROCESS (src/script-workflows/harness.ts), so
    // anything in `process.env` here is directly readable by attacker-supplied
    // code. `buildSandboxedCommand` also wraps the spawn in the shared
    // ulimit sandbox and replaces the env with exactly this object (`env -i`),
    // so the child never inherits the server's full process.env either.
    const harnessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TMPDIR: tmpdir,
      MCP_BASE_URL: baseUrl,
      SCRIPT_RUN_ID: run.id,
      SCRIPT_RUN_AGENT_ID: run.agentId,
      SCRIPT_RUN_TMPDIR: tmpdir,
      SCRIPT_RUN_SOURCE_FILE: sourceFile,
      SCRIPT_RUN_ARGS_FILE: argsFile,
      // Durable, restart-surviving reference for a shared absolute
      // ctx.step.agentTask wait deadline — see workflow-ctx.ts. Sourced
      // from the persisted run row (not Date.now() at spawn time) so a
      // supervisor-restarted process computes the SAME deadline as the
      // original one, and from the server's own limits.ts (not raw env
      // passthrough) so the subprocess never re-interprets the env var.
      SCRIPT_RUN_STARTED_AT: run.startedAt,
      SCRIPT_RUN_MAX_WALL_MS: String(scriptRunMaxWallMs()),
    };

    const proc = Bun.spawn(
      buildSandboxedCommand(["bun", "run", getScriptWorkflowHarnessPath()], harnessEnv),
      {
        cwd: tmpdir,
        // On POSIX, Bun.spawn only needs PATH itself to find the `sh` binary
        // — the sandboxed command's `env -i` prelude scrubs the child down
        // to `harnessEnv` above, so no secret rides on this outer env
        // either. On win32 there is no such prelude, so `sandboxSpawnEnv`
        // passes `harnessEnv` through directly instead — see
        // `buildSandboxedCommand`'s win32 doc comment.
        env: sandboxSpawnEnv(harnessEnv),
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      },
    );

    // Bearer travels over stdin, never as an env var — matches the inline
    // scripts-runtime convention (CLAUDE.md: config injection over stdin,
    // not env). The harness reads this before doing anything else and never
    // re-exposes it via process.env.
    proc.stdin.write(JSON.stringify({ apiKey }));
    proc.stdin.end();

    const stderrPromise = readStreamCapped(proc.stderr, MAX_STDERR_BYTES).then(
      ({ text, truncated }) => (truncated ? `${text}\n…[stderr truncated]` : text),
      () => "",
    );

    return {
      pid: proc.pid,
      tmpdir,
      startedAtMs: Date.now(),
      exited: proc.exited.then(async (exitCode) => ({
        exitCode,
        stderr: await stderrPromise,
      })),
      terminate: (signal = "SIGTERM") => {
        proc.kill(signal);
      },
      cleanup: async () => {
        await rm(tmpdir, { recursive: true, force: true });
      },
    };
  }

  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  terminatePid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    process.kill(pid, signal);
  }
}

export const localProcessScriptExecutor = new LocalProcessScriptExecutor();
