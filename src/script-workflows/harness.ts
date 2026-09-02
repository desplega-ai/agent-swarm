import { createConnection } from "node:net";
import { createCapabilityClient } from "./capability-bridge";
import { buildGuestWorkflowCtx } from "./guest-ctx";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function stringifyResult(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function connectCapabilityClient(socketPath: string, token: string) {
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "hello", token })}\n`);
      resolve();
    });
    socket.once("error", reject);
  });
  const client = createCapabilityClient((message) => {
    if (socket.destroyed) throw new Error("Workflow capability host disconnected");
    socket.write(`${message}\n`);
  });
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const message = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (message) client.handleMessage(message);
    }
  });
  socket.on("close", () => client.disconnect(new Error("Workflow capability host disconnected")));
  socket.on("error", (error) => client.disconnect(error));
  return { client, connected, socket };
}

async function run(): Promise<void> {
  const sourceFile = requiredEnv("SCRIPT_RUN_SOURCE_FILE");
  const argsFile = requiredEnv("SCRIPT_RUN_ARGS_FILE");
  const resultFile = requiredEnv("SCRIPT_RUN_RESULT_FILE");
  const errorFile = requiredEnv("SCRIPT_RUN_ERROR_FILE");
  const userModulePath = `${requiredEnv("SCRIPT_RUN_TMPDIR")}/user-module/user-script.ts`;
  const args = JSON.parse(await Bun.file(argsFile).text());
  const connection = connectCapabilityClient(
    requiredEnv("SCRIPT_RUN_CAPABILITY_SOCKET"),
    requiredEnv("SCRIPT_RUN_CAPABILITY_TOKEN"),
  );

  try {
    await connection.connected;
    const source = await Bun.file(sourceFile).text();
    await Bun.write(userModulePath, source);
    const mod = await import(userModulePath);
    if (typeof mod.default !== "function") {
      throw new Error("Script workflow must export a default function");
    }
    const ctx = buildGuestWorkflowCtx({
      runId: requiredEnv("SCRIPT_RUN_ID"),
      agentId: requiredEnv("SCRIPT_RUN_AGENT_ID"),
      args,
      invokeTool: connection.client.invokeTool,
    });
    const output = await mod.default(args, ctx);
    await Bun.write(resultFile, stringifyResult(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error instanceof Error ? error.stack || message : message);
    await Bun.write(errorFile, JSON.stringify({ message })).catch(() => {});
    process.exitCode = 1;
  } finally {
    connection.client.disconnect(new Error("Workflow capability guest completed"));
    // Nothing remains in flight after the user function settles. Destroy the
    // local transport synchronously so Bun's --no-orphans shutdown does not
    // race a half-closed Unix socket and abort the otherwise clean guest.
    connection.socket.destroy();
  }
}

await run();
