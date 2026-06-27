import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScriptRun } from "@swarm/types";

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
  if (!runtimeDir) return new URL("./harness.ts", import.meta.url).pathname;

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

    const proc = Bun.spawn(["bun", "run", getScriptWorkflowHarnessPath()], {
      cwd: tmpdir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        TMPDIR: tmpdir,
        AGENT_SWARM_API_KEY: apiKey,
        MCP_BASE_URL: baseUrl,
        SCRIPT_RUN_ID: run.id,
        SCRIPT_RUN_AGENT_ID: run.agentId,
        SCRIPT_RUN_TMPDIR: tmpdir,
        SCRIPT_RUN_SOURCE_FILE: sourceFile,
        SCRIPT_RUN_ARGS_FILE: argsFile,
      },
    });

    const stderrPromise = new Response(proc.stderr).text().catch(() => "");

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
