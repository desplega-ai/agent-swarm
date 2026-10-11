import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { getDbClient } from "../be/db";
import { ensureRuntimeOwnerId, reconcileRemoteProvisions } from "../be/runtime-pools/controllers";
import { getRuntimeController } from "../be/runtime-pools/db";
import {
  installRemoteController,
  RemoteController,
  remoteControllerSession,
  removeRemoteController,
} from "../be/runtime-pools/remote-controller";
import { reconcileControllerOrphans } from "../be/runtime-pools/supervisor";
import {
  CONTROLLER_PING_INTERVAL_MS,
  CONTROLLER_PROTOCOL_VERSION,
  ControllerClientMessageSchema,
} from "../runtime-providers/controller-protocol";
import { getApiKey } from "../utils/api-key";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { registerSessionTokenConnection } from "../utils/session-token-connections";
import { resolveHttpRequestAuth } from "./auth";
import { route } from "./route-def";

const connectRoute = route({
  method: "get",
  path: "/api/controllers/connect",
  pattern: ["api", "controllers", "connect"],
  summary: "Connect a remote runtime controller",
  description:
    "Requires a controller token and a WebSocket upgrade. Accepts one session per controller.",
  tags: ["Runtime pools"],
  responses: {
    101: { description: "Controller socket connected" },
    401: { description: "Controller token required" },
    404: { description: "Runtime pools disabled" },
  },
});

type ControllerAuth = Extract<HttpRequestAuth, { kind: "controller" }>;
class ControllerAuthError extends Error {}

async function reconcileHandles(controller: RemoteController): Promise<void> {
  const ownerId = await ensureRuntimeOwnerId();
  const handles = await controller.list(ownerId);
  await reconcileRemoteProvisions(controller.id, handles, ownerId);
  await reconcileControllerOrphans(controller.id, controller, ownerId, new Date(), handles);
}

export function attachControllerTransport(
  server: Server,
  options: { commandTimeoutMs?: number; provisionTimeoutMs?: number } = {},
): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let closing = false;
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!connectRoute.match(req.method, (req.url?.split("?")[0] ?? "").split("/").filter(Boolean)))
      return;
    if (closing || !isRuntimePoolsEnabled()) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    void resolveHttpRequestAuth(req, getApiKey(), { touchSessionToken: false })
      .then((auth) => {
        if (auth?.kind !== "controller") throw new Error("Controller token required");
        if (closing || socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => connect(ws, req, auth));
      })
      .catch(() => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  };
  server.on("upgrade", onUpgrade);

  function connect(ws: WebSocket, req: IncomingMessage, auth: ControllerAuth): void {
    let session: RemoteController | undefined;
    let closed = false;
    let helloReceived = false;
    let online = false;
    let alive = true;
    const unregister = registerSessionTokenConnection(auth.tokenId, () =>
      ws.close(1008, "Controller token revoked"),
    );
    const reportError = (error: unknown) =>
      console.error("[runtime-controller]", scrubSecrets(String(error)));
    const closeOnError = (error: unknown) => {
      const detail = scrubSecrets(String(error));
      void getDbClient()
        .run(
          "UPDATE runtime_controllers SET last_error = ?, last_error_at = ?, status = CASE WHEN status = 'online' THEN status ELSE 'offline' END WHERE id = ?",
          [detail, new Date().toISOString(), auth.controllerId],
        )
        .catch(reportError)
        .finally(() =>
          ws.close(
            error instanceof ControllerAuthError ? 1008 : 1011,
            error instanceof ControllerAuthError
              ? "Controller access rejected"
              : "controller operation failed",
          ),
        );
    };
    const checkAuth = async () => {
      const current = await resolveHttpRequestAuth(req, getApiKey(), { touchSessionToken: false });
      if (current?.kind !== "controller" || current.tokenId !== auth.tokenId)
        throw new ControllerAuthError("Controller token revoked or expired");
      if (!isRuntimePoolsEnabled()) throw new Error("Runtime pools disabled");
    };
    const hello = async (
      message: Extract<ReturnType<typeof ControllerClientMessageSchema.parse>, { type: "hello" }>,
    ) => {
      await checkAuth();
      const row = await getRuntimeController(auth.controllerId);
      if (!row || message.controllerId !== auth.controllerId || message.kind !== row.kind) {
        throw new ControllerAuthError("Controller identity or kind does not match");
      }
      if (closed) return;
      await getDbClient().run("UPDATE runtime_controllers SET status = 'unknown' WHERE id = ?", [
        row.id,
      ]);
      if (closed) return;
      session = new RemoteController(
        row.id,
        ws,
        message.traits,
        row.config.WORKER_API_URL,
        options,
      );
      installRemoteController(session);
      await reconcileHandles(session);
      await checkAuth();
      if (closed || remoteControllerSession(row.id) !== session) return;
      await getDbClient().run(
        "UPDATE runtime_controllers SET status = 'online', last_seen_at = ?, updated_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?",
        [new Date().toISOString(), new Date().toISOString(), row.id],
      );
      online = true;
    };
    ws.on("message", (data) => {
      try {
        const message = ControllerClientMessageSchema.parse(JSON.parse(data.toString()));
        if (message.type === "result") {
          session?.result(message);
          return;
        }
        if (helloReceived) throw new Error("Controller already sent hello");
        helloReceived = true;
        void hello(message).catch(closeOnError);
      } catch {
        ws.close(1002, "Invalid controller message");
      }
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => ws.close(1011, "Controller connection failed"));
    const timer = setInterval(() => {
      if (!alive || !helloReceived) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      void (async () => {
        await checkAuth();
        if (online && session && remoteControllerSession(auth.controllerId) === session)
          await getDbClient().run("UPDATE runtime_controllers SET last_seen_at = ? WHERE id = ?", [
            new Date().toISOString(),
            auth.controllerId,
          ]);
      })().catch(closeOnError);
    }, CONTROLLER_PING_INTERVAL_MS);
    timer.unref();
    ws.on("close", () => {
      closed = true;
      clearInterval(timer);
      unregister();
      session?.disconnect("Controller disconnected");
      if (!session || !removeRemoteController(session)) return;
      const disconnectedAt = new Date().toISOString();
      void getDbClient()
        .run(
          online
            ? "UPDATE runtime_controllers SET status = 'offline', updated_at = ?, last_seen_at = ? WHERE id = ?"
            : "UPDATE runtime_controllers SET status = 'offline' WHERE id = ?",
          online ? [disconnectedAt, disconnectedAt, auth.controllerId] : [auth.controllerId],
        )
        .catch(reportError);
    });
    ws.send(
      JSON.stringify({
        type: "welcome",
        controllerId: auth.controllerId,
        version: CONTROLLER_PROTOCOL_VERSION,
      }),
    );
    void checkAuth().catch(closeOnError);
  }

  return () => {
    closing = true;
    server.off("upgrade", onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
