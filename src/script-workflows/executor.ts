import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SDK_RESPONSE_LIMIT_BYTES } from "../scripts-runtime/response-limit";
import type { ScriptRun } from "../types";
import {
  buildSandboxedCommand,
  readStreamCapped,
  sandboxSpawnEnv,
} from "../utils/sandboxed-process";
import { handleCapabilityRequest } from "./capability-bridge";
import { scriptRunMaxWallMs } from "./limits";
import { isWorkflowSwarmCapabilityAllowed } from "./swarm-capabilities";
import { type BuiltWorkflowCtx, buildWorkflowCtx } from "./workflow-ctx";

/** Matches the inline scripts-runtime cap (src/scripts-runtime/executors/types.ts). */
const MAX_STDERR_BYTES = 1_048_576;
const MAX_CAPABILITY_REQUESTS_PER_TURN = 4;

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

function stringifyResult(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function dispatchCapability(
  built: BuiltWorkflowCtx,
  path: string,
  argsJson: string,
): Promise<string> {
  const args = JSON.parse(argsJson) as unknown;

  if (path.startsWith("swarm.")) {
    const method = path.slice("swarm.".length);
    if (!method || method.includes(".")) throw new Error(`Invalid swarm capability path: ${path}`);
    if (!isWorkflowSwarmCapabilityAllowed(method)) {
      throw new Error(`Workflow swarm capability '${method}' is not allowlisted`);
    }
    const capability = built.ctx.swarm[method];
    if (!capability) throw new Error(`Unknown workflow capability: ${path}`);
    return stringifyResult(await capability(args));
  }

  if (path === "step.humanInTheLoop") {
    return stringifyResult(await built.ctx.step.humanInTheLoop());
  }

  if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== "string") {
    throw new Error(`Invalid arguments for capability ${path}`);
  }
  const [label, config] = args;
  switch (path) {
    case "step.rawLlm":
      return stringifyResult(
        await built.ctx.step.rawLlm(label, config as Parameters<typeof built.ctx.step.rawLlm>[1]),
      );
    case "step.agentTask":
      return stringifyResult(
        await built.ctx.step.agentTask(
          label,
          config as Parameters<typeof built.ctx.step.agentTask>[1],
        ),
      );
    case "step.swarmScript":
      return stringifyResult(
        await built.ctx.step.swarmScript(
          label,
          config as Parameters<typeof built.ctx.step.swarmScript>[1],
        ),
      );
    default:
      throw new Error(`Unknown workflow capability: ${path}`);
  }
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
    const tmpdir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", `script-workflow-${run.id}-`));
    const sourceFile = `${tmpdir}/source.ts`;
    const argsFile = `${tmpdir}/args.json`;
    const resultFile = `${tmpdir}/result.json`;
    const errorFile = `${tmpdir}/error.json`;
    const socketPath = `${tmpdir}/capability.sock`;
    const capabilityToken = randomUUID();
    await Bun.write(sourceFile, run.source);
    await Bun.write(argsFile, JSON.stringify(run.args ?? null));

    // The executor is the trusted broker. It alone holds the bearer and
    // turns guest JSON capability calls into authenticated HTTP requests.
    const built = buildWorkflowCtx({
      runId: run.id,
      agentId: run.agentId,
      apiKey,
      baseUrl,
      args: run.args,
      runStartedAt: run.startedAt,
      runMaxWallMs: scriptRunMaxWallMs(),
    });
    let proc: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    let capabilitySocket: Socket | undefined;
    let protocolFailure: Error | undefined;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // The harness authenticates before it imports user code. Reject later
      // connections once that handshake has claimed the bridge.
      if (capabilitySocket) {
        socket.destroy();
        return;
      }
      socket.setEncoding("utf8");
      let buffered = "";
      let authenticated = false;
      let queuedResponseBytes = 0;
      let processingScheduled = false;
      const handshakeTimeout = setTimeout(() => {
        if (!authenticated) socket.destroy();
      }, 2_000);
      handshakeTimeout.unref?.();
      socket.once("close", () => clearTimeout(handshakeTimeout));

      const failProtocol = (error: unknown) => {
        protocolFailure =
          error instanceof Error ? error : new Error(`Capability protocol failed: ${error}`);
        built.abortInFlightSteps(protocolFailure);
        socket.destroy();
        proc?.kill();
      };

      const writeResponse = (response: string): Promise<void> => {
        const framed = `${response}\n`;
        const bytes = Buffer.byteLength(framed);
        if (queuedResponseBytes + bytes > SCRIPT_SDK_RESPONSE_LIMIT_BYTES) {
          return Promise.reject(
            new Error("Workflow capability response queue exceeded the 64 MiB limit"),
          );
        }
        queuedResponseBytes += bytes;
        return new Promise((resolveWrite, reject) => {
          socket.write(framed, (error) => {
            queuedResponseBytes -= bytes;
            if (error) reject(error);
            else resolveWrite();
          });
        });
      };

      const processBuffered = () => {
        if (socket.destroyed) return;
        let processed = 0;
        while (processed < MAX_CAPABILITY_REQUESTS_PER_TURN) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const message = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!message) continue;
          if (!authenticated) {
            let hello: unknown;
            try {
              hello = JSON.parse(message);
            } catch {
              socket.destroy();
              return;
            }
            if (
              !hello ||
              typeof hello !== "object" ||
              (hello as { type?: unknown }).type !== "hello" ||
              (hello as { token?: unknown }).token !== capabilityToken
            ) {
              socket.destroy();
              return;
            }
            if (capabilitySocket) {
              socket.destroy();
              return;
            }
            capabilitySocket = socket;
            authenticated = true;
            clearTimeout(handshakeTimeout);
            continue;
          }
          processed += 1;
          void handleCapabilityRequest(message, (path, argsJson) =>
            dispatchCapability(built, path, argsJson),
          )
            .then(writeResponse)
            .catch(failProtocol);
        }
        if (buffered.includes("\n") && !processingScheduled) {
          processingScheduled = true;
          queueMicrotask(() => {
            processingScheduled = false;
            processBuffered();
          });
        }
      };

      socket.on("data", (chunk) => {
        buffered += chunk;
        if (Buffer.byteLength(buffered) > SCRIPT_SDK_RESPONSE_LIMIT_BYTES) {
          const error = new Error("Workflow capability request exceeded the 64 MiB limit");
          if (authenticated) failProtocol(error);
          else socket.destroy();
          return;
        }
        processBuffered();
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
      HOME: process.env.HOME ?? "/tmp",
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
      proc = Bun.spawn(buildSandboxedCommand(["bun", "run", harnessPath], harnessEnv), {
        cwd: tmpdir,
        env: sandboxSpawnEnv(harnessEnv),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(tmpdir, { recursive: true, force: true });
      throw error;
    }

    const heartbeat = setInterval(() => {
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
    const exited = spawned.exited.then(async (processExitCode) => {
      clearInterval(heartbeat);
      let stderr = await stderrPromise;
      try {
        if (protocolFailure) throw protocolFailure;
        if (processExitCode !== 0) {
          const file = Bun.file(errorFile);
          const failure = (await file.exists())
            ? (JSON.parse(await file.text()) as { message?: unknown })
            : undefined;
          const message =
            typeof failure?.message === "string"
              ? failure.message
              : `guest exited with ${processExitCode}`;
          throw new Error(message);
        }
        const output = JSON.parse(await Bun.file(resultFile).text());
        await postStatus(run, baseUrl, apiKey, { status: "completed", output });
        return { exitCode: 0, stderr };
      } catch (error) {
        await built.drainInFlightSteps().catch(() => {});
        built.abortInFlightSteps();
        stderr = appendError(stderr, error);
        try {
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
      terminate: (signal = "SIGTERM") => {
        built.abortInFlightSteps();
        spawned.kill(signal);
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

  terminatePid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    process.kill(pid, signal);
  }
}

export const localProcessScriptExecutor = new LocalProcessScriptExecutor();
