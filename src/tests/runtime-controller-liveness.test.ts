import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import { startControllerClient } from "../commands/controller";
import { CONTROLLER_PROTOCOL_VERSION } from "../runtime-providers/controller-protocol";
import type { RuntimeProvider } from "../runtime-providers/types";
import { listenOnFreePort } from "./test-net";

const LIVENESS_MS = 300;
const WELCOME = JSON.stringify({
  type: "welcome",
  controllerId: "controller-1",
  version: CONTROLLER_PROTOCOL_VERSION,
});

const provider = {
  kind: "docker",
  traits: { canProvision: true, ephemeralDisk: true, supportsPause: false },
  checkConfig: () => ({ ready: true, missing: [] }),
} as unknown as RuntimeProvider;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// A raw TCP WebSocket peer. Under Bun, `ws` maps to a native shim that always answers
// pings, so it cannot model a dead link. This peer completes the handshake, sends
// welcome, and then never answers a frame: what a cut network looks like to the client.
async function startRawServer(options: { pingEveryMs?: number } = {}) {
  let connections = 0;
  const sockets: Socket[] = [];
  const server = createNetServer((socket) => {
    sockets.push(socket);
    socket.once("data", (data) => {
      const key = /sec-websocket-key: *(\S+)/i.exec(data.toString())?.[1];
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const payload = Buffer.from(WELCOME);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      connections++;
      if (options.pingEveryMs) {
        const timer = setInterval(
          () => socket.write(Buffer.from([0x89, 0x00])),
          options.pingEveryMs,
        );
        socket.once("close", () => clearInterval(timer));
      }
    });
    socket.on("error", () => {});
  });
  const port = await listenOnFreePort(server);
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { apiUrl: `http://127.0.0.1:${port}`, connections: () => connections };
}

function startClient(apiUrl: string) {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const client = startControllerClient({
    apiUrl,
    token: "aseph_test-token",
    provider,
    target: {},
    livenessTimeoutMs: LIVENESS_MS,
  });
  cleanups.push(() => {
    client.stop();
    logSpy.mockRestore();
  });
  return { logs: () => logSpy.mock.calls.flat().join("\n") };
}

async function until(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(20);
  }
}

test("a server that goes silent without closing makes the client reconnect", async () => {
  const server = await startRawServer();
  const { logs } = startClient(server.apiUrl);
  await until(() => logs().includes("Connected as controller-1"), 2000);
  const silentAt = Date.now();
  // Detection within the timeout plus one check interval, then the first backoff (at most 1000ms).
  await until(() => server.connections() === 2, LIVENESS_MS * 2 + 1500);
  expect(logs()).toContain(`No traffic for ${LIVENESS_MS}ms`);
  expect(logs()).toContain("Disconnected. Reconnect in");
  expect(Date.now() - silentAt).toBeGreaterThanOrEqual(LIVENESS_MS);
});

test("server ping frames keep an idle controller connected", async () => {
  // Matches the API: it pings on an interval and sends no app message to an idle controller.
  // This peer never answers the client's pings, so only the server pings count.
  const server = await startRawServer({ pingEveryMs: LIVENESS_MS / 3 });
  const { logs } = startClient(server.apiUrl);
  await until(() => logs().includes("Connected as controller-1"), 2000);
  await Bun.sleep(LIVENESS_MS * 4);
  expect(server.connections()).toBe(1);
  expect(logs()).not.toContain("Disconnected");
});

test("pongs to client pings keep an idle controller connected", async () => {
  // A healthy peer that sends nothing on its own still answers pings.
  const http = createHttpServer();
  const wss = new WebSocketServer({ server: http });
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.send(WELCOME);
  });
  const port = await listenOnFreePort(http);
  cleanups.push(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    http.close();
  });
  const { logs } = startClient(`http://127.0.0.1:${port}`);
  await until(() => logs().includes("Connected as controller-1"), 2000);
  await Bun.sleep(LIVENESS_MS * 4);
  expect(connections).toBe(1);
  expect(logs()).not.toContain("Disconnected");
});
