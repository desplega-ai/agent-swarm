import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chown, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunDirFileCheck, readRunDirFile } from "../scripts-runtime/executors/native";
import { SCRIPT_SDK_RESPONSE_LIMIT_BYTES } from "../scripts-runtime/response-limit";
import type { ScriptRun } from "../types";
import {
  detachedProcessGroup,
  forceTerminateProcessGroup,
  registerProcessGroup,
  signalProcessGroup,
  terminateProcessGroup,
} from "../utils/process-group";
import {
  buildSandboxedCommand,
  DEFAULT_SANDBOX_LIMITS,
  readStreamCapped,
  resolveSandboxIdentity,
  sandboxSpawnEnv,
} from "../utils/sandboxed-process";
import { createCapabilitySession } from "./capability-session";

export { dispatchCapability, MAX_ACTIVE_CAPABILITY_DISPATCHES } from "./capability-session";

/** Matches the inline scripts-runtime cap (src/scripts-runtime/executors/types.ts). */
const MAX_STDERR_BYTES = 1_048_576;

export type ScriptExecutionResult = {
  exitCode: number | null;
  stderr: string;
  terminated?: boolean;
  output?: unknown;
};

export type ScriptExecutionHandle = {
  pid: number | null;
  tmpdir: string;
  startedAtMs: number;
  exited: Promise<ScriptExecutionResult>;
  terminate(signal?: NodeJS.Signals): Promise<void>;
  cleanup(): Promise<void>;
};

export type StartScriptExecutionInput = {
  run: ScriptRun;
  baseUrl: string;
  apiKey: string;
  capabilityRelay?: (frame: string, send: (response: string) => Promise<void>) => Promise<void>;
};

export interface ScriptExecutor {
  start(input: StartScriptExecutionInput): Promise<ScriptExecutionHandle>;
  isRunning(pid: number): boolean;
  terminatePid(pid: number, signal?: NodeJS.Signals): Promise<void>;
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

async function postStatus(
  run: ScriptRun,
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/internal/script-runs/${run.id}/status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": run.agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`status callback failed with ${res.status}: ${await res.text()}`);
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function appendError(stderr: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return stderr ? `${stderr.trimEnd()}\n${message}` : message;
}

export class LocalProcessScriptExecutor implements ScriptExecutor {
  async start(input: StartScriptExecutionInput): Promise<ScriptExecutionHandle> {
    const { run, apiKey } = input;
    const baseUrl = input.baseUrl.replace(/\/$/, "");
    const harnessPath = getScriptWorkflowHarnessPath();
    // Same identity as the native script executor: nobody:nogroup on a root API.
    const runAs = resolveSandboxIdentity();
    const tmpdir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", `script-workflow-${run.id}-`));
    const sourceFile = `${tmpdir}/source.ts`;
    const argsFile = `${tmpdir}/args.json`;
    const resultFile = `${tmpdir}/result.json`;
    const errorFile = `${tmpdir}/error.json`;
    const socketPath = `${tmpdir}/capability.sock`;
    const capabilityToken = randomUUID();
    await Bun.write(sourceFile, run.source);
    await Bun.write(argsFile, JSON.stringify(run.args ?? null));

    const session = input.capabilityRelay
      ? {
          built: { abortInFlightSteps(_error?: Error) {}, async drainInFlightSteps() {} },
          authenticate(frame: string) {
            try {
              const hello = JSON.parse(frame);
              return hello.type === "hello" && hello.token === capabilityToken;
            } catch {
              return false;
            }
          },
          receive: input.capabilityRelay,
        }
      : createCapabilitySession(input, capabilityToken);
    const built = session.built;
    let proc: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    let capabilitySocket: Socket | undefined;
    let protocolFailure: Error | undefined;
    let terminated = false;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      if (capabilitySocket) return socket.destroy();
      sockets.add(socket);
      let buffered = "";
      let authenticated = false;
      const timeout = setTimeout(() => socket.destroy(), 2000);
      const fail = (error: unknown) => {
        if (authenticated) {
          protocolFailure ??= error instanceof Error ? error : new Error(String(error));
          built.abortInFlightSteps(protocolFailure);
          proc?.kill();
        }
        socket.destroy();
      };
      socket.once("close", () => {
        clearTimeout(timeout);
        sockets.delete(socket);
      });
      socket.on("error", fail);
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffered += chunk;
        if (Buffer.byteLength(buffered) > SCRIPT_SDK_RESPONSE_LIMIT_BYTES) {
          fail(new Error("Workflow capability request exceeded the 64 MiB limit"));
          return;
        }
        while (buffered.includes("\n")) {
          const newline = buffered.indexOf("\n");
          const frame = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!frame) continue;
          if (!authenticated) {
            if (capabilitySocket || !session.authenticate(frame)) {
              socket.destroy();
              return;
            }
            authenticated = true;
            capabilitySocket = socket;
            clearTimeout(timeout);
          } else {
            void session
              .receive(
                frame,
                (response) =>
                  new Promise<void>((resolve, reject) => {
                    socket.write(`${response}\n`, (error) => (error ? reject(error) : resolve()));
                  }),
              )
              .catch(fail);
          }
        }
      });
    });

    try {
      await listen(server, socketPath);
    } catch (error) {
      await rm(tmpdir, { recursive: true, force: true });
      throw error;
    }

    // This is the only sandboxed process and the only realm that imports
    // user source. Its exact env contains the Unix socket path but no bearer
    // or API base URL; status, heartbeat, and ctx.swarm HTTP stay above it.
    const harnessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      // The dropped identity cannot use the API's HOME.
      HOME: runAs ? tmpdir : (process.env.HOME ?? "/tmp"),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TMPDIR: tmpdir,
      SCRIPT_RUN_ID: run.id,
      SCRIPT_RUN_AGENT_ID: run.agentId,
      SCRIPT_RUN_TMPDIR: tmpdir,
      SCRIPT_RUN_SOURCE_FILE: sourceFile,
      SCRIPT_RUN_ARGS_FILE: argsFile,
      SCRIPT_RUN_RESULT_FILE: resultFile,
      SCRIPT_RUN_ERROR_FILE: errorFile,
      SCRIPT_RUN_CAPABILITY_SOCKET: socketPath,
      SCRIPT_RUN_CAPABILITY_TOKEN: capabilityToken,
    };

    try {
      if (runAs) {
        // The guest writes its user module and result files into the run dir
        // and connects to the capability socket.
        await Promise.all(
          [tmpdir, sourceFile, argsFile, socketPath].map((path) =>
            chown(path, runAs.uid, runAs.gid),
          ),
        );
      }
      const command = buildSandboxedCommand(
        ["bun", "run", harnessPath],
        harnessEnv,
        DEFAULT_SANDBOX_LIMITS,
        "inline",
        runAs,
      );
      proc = registerProcessGroup(
        Bun.spawn(command, {
          cwd: tmpdir,
          detached: detachedProcessGroup,
          // On POSIX, Bun.spawn only needs PATH itself to find the `sh` binary
          // — the sandboxed command's `env -i` prelude scrubs the child down
          // to `harnessEnv` above, so no secret rides on this outer env
          // either. On win32 there is no such prelude, so `sandboxSpawnEnv`
          // passes `harnessEnv` through directly instead — see
          // `buildSandboxedCommand`'s win32 doc comment.
          env: sandboxSpawnEnv(harnessEnv),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }),
      );
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(tmpdir, { recursive: true, force: true });
      throw error;
    }

    const heartbeat = setInterval(() => {
      if (!input.capabilityRelay)
        fetch(`${baseUrl}/api/internal/script-runs/${run.id}/heartbeat`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "X-Agent-ID": run.agentId },
        }).catch(() => {});
    }, 10_000);
    heartbeat.unref?.();

    const stderrPromise = readStreamCapped(proc.stderr, MAX_STDERR_BYTES).then(
      ({ text, truncated }) => (truncated ? `${text}\n…[stderr truncated]` : text),
      () => "",
    );
    const spawned = proc;
    // The guest owns the run dir: read its files only through the checked reader.
    const runDirCheck: RunDirFileCheck = {
      // ulimit -f already bounds what the guest can write.
      maxBytes: DEFAULT_SANDBOX_LIMITS.maxFileKb * 1024,
      ...(runAs ? { ownerUid: runAs.uid } : {}),
    };
    const exited = spawned.exited.then(async (processExitCode) => {
      clearInterval(heartbeat);
      await terminateProcessGroup(spawned.pid);
      let stderr = await stderrPromise;
      // The caller owns the status for pause/cancel/limits. On API shutdown,
      // leaving it running lets the next supervisor replay the durable journal.
      if (terminated) return { exitCode: processExitCode, stderr, terminated: true };
      try {
        if (protocolFailure) throw protocolFailure;
        if (processExitCode !== 0) {
          const errorText = await readRunDirFile(errorFile, runDirCheck);
          const failure =
            errorText === undefined ? undefined : (JSON.parse(errorText) as { message?: unknown });
          const message =
            typeof failure?.message === "string"
              ? failure.message
              : `guest exited with ${processExitCode}`;
          throw new Error(message);
        }
        const resultText = await readRunDirFile(resultFile, runDirCheck);
        if (resultText === undefined) throw new Error("guest wrote no readable result file");
        const output = JSON.parse(resultText);
        if (!input.capabilityRelay)
          await postStatus(run, baseUrl, apiKey, { status: "completed", output });
        return { exitCode: 0, stderr, output };
      } catch (error) {
        await built.drainInFlightSteps().catch(() => {});
        built.abortInFlightSteps();
        stderr = appendError(stderr, error);
        try {
          if (!input.capabilityRelay)
            await postStatus(run, baseUrl, apiKey, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
        } catch (statusError) {
          stderr = appendError(stderr, statusError);
        }
        return { exitCode: processExitCode || 1, stderr };
      }
    });

    return {
      pid: spawned.pid,
      tmpdir,
      startedAtMs: Date.now(),
      exited,
      terminate: async (signal = "SIGTERM") => {
        terminated = true;
        built.abortInFlightSteps();
        if (signal === "SIGTERM") await terminateProcessGroup(spawned.pid);
        else if (signal === "SIGKILL") forceTerminateProcessGroup(spawned.pid);
        else signalProcessGroup(spawned.pid, signal);
      },
      cleanup: async () => {
        clearInterval(heartbeat);
        built.abortInFlightSteps();
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
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

  async terminatePid(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (signal === "SIGTERM") await terminateProcessGroup(pid);
    else if (signal === "SIGKILL") forceTerminateProcessGroup(pid);
    else signalProcessGroup(pid, signal);
  }
}

export const localProcessScriptExecutor = new LocalProcessScriptExecutor();
