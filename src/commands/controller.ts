import { createRuntimeProvider } from "../runtime-providers";
import { BuiltinController } from "../runtime-providers/controller";
import {
  CONTROLLER_PING_INTERVAL_MS,
  CONTROLLER_PROTOCOL_VERSION,
  type ControllerCommand,
  ControllerServerMessageSchema,
} from "../runtime-providers/controller-protocol";
import type { RuntimeProvider, RuntimeTargetConfig } from "../runtime-providers/types";
import { RuntimeProviderKindSchema } from "../types";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";

async function executeCommand(
  controller: BuiltinController,
  command: ControllerCommand,
): Promise<unknown> {
  switch (command.op) {
    case "provision":
      return await controller.provision(command.payload);
    case "terminate":
      return await controller.terminate(command.payload.handle, command.payload.reason);
    case "status":
      return await controller.status(command.payload.handles);
    case "list":
      return await controller.list(command.payload.ownerId);
    case "renew": {
      if (!controller.renew) throw new Error("Controller does not support lease renewal");
      return await controller.renew(command.payload.handle, command.payload.ttlSec);
    }
    case "pause": {
      if (!controller.pause) throw new Error("Controller does not support pause");
      return await controller.pause(command.payload.handle);
    }
    case "resume": {
      if (!controller.resume) throw new Error("Controller does not support resume");
      return await controller.resume(command.payload.handle);
    }
  }
}

// A network cut never closes the socket on this side, so the client watches inbound
// traffic. The API pings every CONTROLLER_PING_INTERVAL_MS and the client pings on
// each check; Bun surfaces both as `ping` / `pong` events. Three ping intervals
// without any frame means the link is half-open.
export const CONTROLLER_LIVENESS_TIMEOUT_MS = 3 * CONTROLLER_PING_INTERVAL_MS;

export function startControllerClient(options: {
  apiUrl: string;
  token: string;
  provider: RuntimeProvider;
  target: RuntimeTargetConfig;
  onFatal?: () => void;
  livenessTimeoutMs?: number;
}): { stop: () => void } {
  const livenessTimeoutMs = options.livenessTimeoutMs ?? CONTROLLER_LIVENESS_TIMEOUT_MS;
  const url = new URL("/api/controllers/connect", options.apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Controller API URL must use HTTP or HTTPS");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  registerVolatileSecret(options.token, "controller-client-token");
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let liveness: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;
  const log = (message: string) => console.log(scrubSecrets(`[runtime-controller] ${message}`));

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    socket = ws;
    let controller: BuiltinController | undefined;
    let connectedAt = 0;
    let lastTrafficAt = Date.now();
    const markAlive = () => {
      lastTrafficAt = Date.now();
    };
    ws.addEventListener("ping", markAlive);
    ws.addEventListener("pong", markAlive);
    clearInterval(liveness);
    liveness = setInterval(
      () => {
        if (socket !== ws) return;
        if (Date.now() - lastTrafficAt > livenessTimeoutMs) {
          log(`No traffic for ${livenessTimeoutMs}ms. Dropping the connection`);
          clearInterval(liveness);
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      },
      Math.ceil(livenessTimeoutMs / 3),
    );
    ws.onmessage = (event) => {
      markAlive();
      void (async () => {
        const message = ControllerServerMessageSchema.parse(JSON.parse(String(event.data)));
        if (message.type === "welcome") {
          if (controller) throw new Error("Controller already received welcome");
          controller = new BuiltinController(
            message.controllerId,
            options.provider,
            options.target,
          );
          connectedAt = Date.now();
          ws.send(
            JSON.stringify({
              type: "hello",
              controllerId: message.controllerId,
              kind: options.provider.kind,
              version: CONTROLLER_PROTOCOL_VERSION,
              traits: options.provider.traits,
            }),
          );
          log(`Connected as ${message.controllerId}`);
          return;
        }
        if (!controller) throw new Error("Controller must receive welcome before commands");
        log(`Command ${message.op} ${message.id}`);
        try {
          const result = await executeCommand(controller, message);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, result }));
        } catch (error) {
          const detail = scrubSecrets(String(error));
          log(detail);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: detail }));
        }
      })().catch((error) => {
        log(scrubSecrets(String(error)));
        ws.close(1002, "Invalid controller message");
      });
    };
    ws.onerror = () => log("Connection failed");
    ws.onclose = (event) => {
      if (stopped || socket !== ws) return;
      clearInterval(liveness);
      if (event.code === 1008) {
        stopped = true;
        log("Controller access rejected or token revoked. Mint a token and restart this process.");
        options.onFatal?.();
        return;
      }
      if (event.code === 1001) {
        log("Another controller process holds this token. Reconnect in 300000ms.");
        reconnect = setTimeout(connect, 300_000);
        return;
      }
      if (connectedAt && Date.now() - connectedAt >= 30_000) attempts = 0;
      const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5));
      const delay = Math.max(1000, Math.round(ceiling * (0.75 + Math.random() * 0.25)));
      log(`Disconnected. Reconnect in ${delay}ms`);
      reconnect = setTimeout(connect, delay);
    };
  };
  connect();
  return {
    stop: () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      clearInterval(liveness);
      socket?.close(1000, "Controller stopped");
    },
  };
}

export async function runController(args: string[]): Promise<void> {
  try {
    const flags = new Map<string, string>();
    const allowed = new Set(["--api-url", "--kind", "--docker-host", "--docker-network"]);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!;
      const value = args[i + 1];
      if (!allowed.has(key) || !value || value.startsWith("--"))
        throw new Error("Controller flags require a supported name and a value");
      flags.set(key, value);
    }
    const apiUrl = flags.get("--api-url") ?? process.env.MCP_BASE_URL;
    const token = process.env.AGENT_SWARM_CONTROLLER_TOKEN;
    if (!apiUrl || !token?.startsWith("aseph_"))
      throw new Error("Controller requires --api-url and AGENT_SWARM_CONTROLLER_TOKEN");
    const kind = RuntimeProviderKindSchema.parse(flags.get("--kind") ?? "docker");
    if (kind === "k8s") throw new Error("Remote k8s controllers are not supported");
    const target: RuntimeTargetConfig = {
      DOCKER_HOST: flags.get("--docker-host") ?? process.env.DOCKER_HOST,
      DOCKER_NETWORK: flags.get("--docker-network") ?? process.env.DOCKER_NETWORK,
      DOCKER_EXTRA_HOSTS: process.env.DOCKER_EXTRA_HOSTS,
      E2B_API_KEY: process.env.E2B_API_KEY,
      E2B_API_BASE: process.env.E2B_API_BASE,
      E2B_TTL_SEC: process.env.E2B_TTL_SEC,
      E2B_MAX_CONTINUOUS_SEC: process.env.E2B_MAX_CONTINUOUS_SEC,
    };
    const provider = await createRuntimeProvider(kind, target);
    const config = provider.checkConfig(target);
    if (!config.ready)
      throw new Error(config.hint ?? `Missing configuration: ${config.missing.join(", ")}`);
    const client = startControllerClient({
      apiUrl,
      token,
      provider,
      target,
      onFatal: () => process.exit(1),
    });
    process.once("SIGTERM", () => client.stop());
    process.once("SIGINT", () => client.stop());
  } catch (error) {
    console.error(scrubSecrets(`[runtime-controller] ${String(error)}`));
    process.exitCode = 1;
  }
}
