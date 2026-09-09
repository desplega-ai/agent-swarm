import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import WebSocket from "ws";
import * as Y from "yjs";
import { createDocument } from "../realtime/document";
import { getFreePort, SERVER_BOOT_HOOK_TIMEOUT_MS, waitForServer } from "./test-net";

type Frame = Record<string, any>;
type SocketHeaders = Record<string, string>;

const dbPath = `/tmp/test-realtime-transport-${Date.now()}-${randomUUID()}.sqlite`;
const apiKey = `realtime-test-${randomUUID()}`;
const pageSecret = `realtime-page-secret-${randomUUID()}`;
let baseUrl = "";
let socketUrl = "";
let server: Subprocess;
const sockets = new Set<WebSocket>();

function jsonHeaders(extra: SocketHeaders = {}): SocketHeaders {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra };
}

async function api(
  method: string,
  path: string,
  options: { body?: unknown; agentId?: string; headers?: SocketHeaders } = {},
): Promise<Response> {
  const headers = jsonHeaders(options.headers);
  if (options.agentId) headers["X-Agent-ID"] = options.agentId;
  return await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function registerAgent(name = `realtime-${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  const response = await api("POST", "/api/agents", {
    agentId: id,
    body: { name, role: "worker", status: "online" },
  });
  expect([200, 201]).toContain(response.status);
  return id;
}

async function createPage(
  agentId: string,
  authMode: "public" | "authed" | "password" = "public",
  password?: string,
): Promise<string> {
  const response = await api("POST", "/api/pages", {
    agentId,
    body: {
      slug: `realtime-${randomUUID().slice(0, 8)}`,
      title: "Realtime transport test",
      contentType: "text/html",
      authMode,
      ...(password ? { password } : {}),
      body: "<h1>realtime</h1>",
    },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id?: string };
  expect(typeof body.id).toBe("string");
  return body.id!;
}

async function launchPage(pageId: string, agentId: string): Promise<string> {
  const response = await api("POST", `/api/pages/${pageId}/launch`, { agentId });
  expect(response.status).toBe(204);
  const cookie = response.headers.get("set-cookie")?.match(/page_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  return `page_session=${cookie}`;
}

async function createUserToken(name: string): Promise<{ id: string; token: string }> {
  const created = await api("POST", "/api/users", { body: { name } });
  expect(created.status).toBe(200);
  const userId = ((await created.json()) as { user?: { id?: string } }).user?.id;
  expect(typeof userId).toBe("string");
  const minted = await api("POST", `/api/users/${userId}/mcp-tokens`, {
    body: { label: "realtime-transport-test" },
  });
  expect(minted.status).toBe(200);
  const token = ((await minted.json()) as { plaintext?: string }).plaintext;
  expect(typeof token).toBe("string");
  return { id: userId!, token: token! };
}

async function launchPageAsUser(pageId: string, token: string): Promise<string> {
  const response = await api("POST", `/api/pages/${pageId}/launch`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(204);
  const cookie = response.headers.get("set-cookie")?.match(/page_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  return `page_session=${cookie}`;
}

async function unlockPasswordPage(pageId: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/p/${pageId}?key=${encodeURIComponent(password)}`);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.match(/page_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  return `page_session=${cookie}`;
}

function openSocket(
  headers: SocketHeaders = {},
  target = socketUrl,
): Promise<{
  ws: WebSocket;
  frames: Frame[];
  next: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
  send: (message: Record<string, unknown>) => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target, { headers });
    sockets.add(ws);
    const frames: Frame[] = [];
    const waiters: Array<{
      predicate: (frame: Frame) => boolean;
      resolve: (frame: Frame) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    let settled = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const next = (predicate: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> => {
      const index = frames.findIndex(predicate);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
      return new Promise((nextResolve, nextReject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          nextReject(
            new Error(`Timed out waiting for realtime frame. Buffered: ${JSON.stringify(frames)}`),
          );
        }, timeoutMs);
        waiters.push({ predicate, resolve: nextResolve, reject: nextReject, timer });
      });
    };
    const send = (message: Record<string, unknown>) => ws.send(JSON.stringify(message));
    ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        return;
      }
      if (typeof frame.seq === "number" && ws.readyState === WebSocket.OPEN) {
        send({ ack: frame.seq });
      }
      const waiter = waiters.find((item) => item.predicate(frame));
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      } else {
        frames.push(frame);
      }
    });
    const fail = (error: Error) => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      if (!settled) {
        settled = true;
        sockets.delete(ws);
        reject(error);
      }
    };
    ws.once("open", () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (settled) return;
      settled = true;
      resolve({ ws, frames, next, send });
    });
    ws.once("unexpected-response", (_request, response) => {
      fail(new Error(`WebSocket handshake rejected with ${response.statusCode}`));
    });
    ws.on("error", () => {});
    ws.once("close", (code, reason) => {
      sockets.delete(ws);
      const error = new Error(`WebSocket closed: ${code} ${reason.toString()}`);
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
    handshakeTimer = setTimeout(
      () => fail(new Error(`WebSocket handshake failed: ${target}`)),
      5_000,
    );
  });
}

function pageSocketUrl(pageId: string): string {
  return `${socketUrl}?pageId=${encodeURIComponent(pageId)}`;
}

async function socketAccepted(headers: SocketHeaders, target: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(target, { headers });
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.delete(ws);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.terminate();
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    ws.once("open", () => finish(true));
    ws.once("unexpected-response", () => finish(false));
    ws.on("error", () => {});
  });
}

async function closeSocket(client: { ws: WebSocket }): Promise<void> {
  if (client.ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.ws.once("close", () => resolve());
    client.ws.close();
  });
}

function snapshot(state: Record<string, unknown>): string {
  const doc = createDocument(state);
  try {
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  } finally {
    doc.destroy();
  }
}

async function join(
  client: Awaited<ReturnType<typeof openSocket>>,
  id: number,
  name: string,
  namespace?: string,
): Promise<Frame> {
  client.send({ id, op: "join", name, namespace, schemaVersion: 1 });
  return await client.next((frame) => frame.type === "result" && frame.id === id);
}

beforeAll(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  socketUrl = `ws://127.0.0.1:${port}/@swarm/realtime`;
  process.env.PAGE_SESSION_SECRET = pageSecret;
  server = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: apiKey,
      AGENT_SWARM_API_KEY: apiKey,
      DATABASE_PATH: dbPath,
      PAGE_SESSION_SECRET: pageSecret,
      MCP_BASE_URL: baseUrl,
      NODE_ENV: "test",
      CAPABILITIES: "core,task-pool,messaging,profiles,services,scheduling,memory,pages",
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      LINEAR_DISABLE: "true",
      JIRA_DISABLE: "true",
      AGENTMAIL_DISABLE: "true",
      OAUTH_KEEPALIVE_DISABLE: "true",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForServer(`${baseUrl}/health`);
}, SERVER_BOOT_HOOK_TIMEOUT_MS);

afterAll(async () => {
  for (const client of [...sockets]) client.close();
  if (server?.exitCode === null) server.kill("SIGTERM");
  await server?.exited.catch(() => {});
  for (const suffix of ["", "-wal", "-shm"]) await unlink(`${dbPath}${suffix}`).catch(() => {});
});

describe("realtime transport", () => {
  test("converges CRDT leaves, isolates rooms, broadcasts channels, and tracks presence", async () => {
    const agentId = await registerAgent();
    const pageId = await createPage(agentId, "public");
    const client1 = await openSocket({ Origin: baseUrl }, pageSocketUrl(pageId));
    const client2 = await openSocket({ Origin: baseUrl }, pageSocketUrl(pageId));
    try {
      const first = await join(client1, 1, "board", "task:agent:spoofed");
      const second = await join(client2, 2, "board");
      expect(first.room.namespace).toBe(`task:page:${pageId}`);
      expect(second.room.namespace).toBe(`task:page:${pageId}`);

      client1.send({
        id: 3,
        op: "update",
        name: "board",
        namespace: "task:agent:spoofed",
        schemaVersion: 1,
        generation: first.room.generation,
        snapshot: snapshot({ left: "one" }),
      });
      await client1.next((frame) => frame.type === "result" && frame.id === 3);
      await client2.next(
        (frame) => frame.type === "room" && frame.name === "board" && frame.state.left === "one",
      );

      client2.send({
        id: 4,
        op: "update",
        name: "board",
        schemaVersion: 1,
        generation: first.room.generation,
        snapshot: snapshot({ right: "two" }),
      });
      const changed = await client2.next((frame) => frame.type === "result" && frame.id === 4);
      expect(changed.room.state).toMatchObject({ left: "one", right: "two" });
      await client1.next(
        (frame) =>
          frame.type === "room" &&
          frame.name === "board" &&
          frame.state.left === "one" &&
          frame.state.right === "two",
      );

      await join(client1, 5, "other-room");
      client1.send({
        id: 6,
        op: "change",
        name: "board",
        schemaVersion: 1,
        generation: first.room.generation,
        operations: [{ type: "set", path: ["changed"], value: true }],
      });
      await client1.next((frame) => frame.type === "result" && frame.id === 6);
      expect(
        client1.frames.some((frame) => frame.type === "room" && frame.name === "other-room"),
      ).toBe(false);

      client2.send({ id: 7, op: "subscribe", name: "events" });
      await client2.next((frame) => frame.type === "result" && frame.id === 7);
      client1.send({ id: 8, op: "publish", name: "events", data: { ok: true } });
      await client1.next((frame) => frame.type === "result" && frame.id === 8);
      await client2.next(
        (frame) => frame.type === "channel" && frame.name === "events" && frame.data.ok,
      );

      client1.send({ id: 9, op: "presence", name: "board", data: { cursor: 3 } });
      await client1.next((frame) => frame.type === "result" && frame.id === 9);
      const presence = await client2.next(
        (frame) =>
          frame.type === "presence" && frame.name === "board" && Array.isArray(frame.peers),
      );
      expect(presence.peers.some((peer: Frame) => peer.userId === first.me.userId)).toBe(true);
      await closeSocket(client1);
      const disconnected = await client2.next(
        (frame) =>
          frame.type === "presence" &&
          frame.name === "board" &&
          Array.isArray(frame.peers) &&
          !frame.peers.some((peer: Frame) => peer.userId === first.me.userId),
      );
      expect(disconnected.peers.some((peer: Frame) => peer.userId === first.me.userId)).toBe(false);
    } finally {
      await closeSocket(client1);
      await closeSocket(client2);
    }
  });

  test("enforces page sessions, origin checks, reset generations, and input limits", async () => {
    const agentId = await registerAgent();
    const pageId = await createPage(agentId, "authed");
    const cookie = await launchPage(pageId, agentId);
    expect(await socketAccepted({ Origin: baseUrl }, pageSocketUrl(pageId))).toBe(false);
    expect(
      await socketAccepted(
        { Origin: "https://viewer.invalid", Cookie: cookie },
        pageSocketUrl(pageId),
      ),
    ).toBe(false);
    const client = await openSocket({ Origin: baseUrl, cookie }, pageSocketUrl(pageId));
    try {
      const joined = await join(client, 1, "limits");
      client.send({
        id: 2,
        op: "change",
        name: "limits",
        generation: joined.room.generation,
        schemaVersion: 1,
        operations: [{ type: "set", path: ["__proto__"], value: "blocked" }],
      });
      const invalid = await client.next(
        (frame) => frame.type === "error" && frame.error === "Invalid realtime message",
      );
      expect(invalid.error).toContain("Invalid realtime message");

      client.send({ id: 3, op: "subscribe", name: "limits-channel" });
      await client.next((frame) => frame.type === "result" && frame.id === 3);
      client.send({ id: 4, op: "publish", name: "limits-channel", data: "x".repeat(65 * 1024) });
      const oversized = await client.next((frame) => frame.type === "error" && frame.id === 4);
      expect(oversized.error).toContain("64 KiB");

      client.send({ id: 5, op: "reset", name: "limits", state: { reset: true }, schemaVersion: 1 });
      const reset = await client.next((frame) => frame.type === "result" && frame.id === 5);
      expect(reset.room.generation).not.toBe(joined.room.generation);
      expect(reset.room.state).toEqual({ reset: true });
      client.send({
        id: 6,
        op: "update",
        name: "limits",
        generation: joined.room.generation,
        schemaVersion: 1,
        snapshot: snapshot({ stale: true }),
      });
      const stale = await client.next((frame) => frame.type === "error" && frame.id === 6);
      expect(stale.error).toMatch(/generation|active/);
    } finally {
      await closeSocket(client);
    }

    const passwordPage = await createPage(agentId, "password", "secret");
    expect(await socketAccepted({ Origin: baseUrl }, pageSocketUrl(passwordPage))).toBe(false);
    const passwordCookie = await unlockPasswordPage(passwordPage, "secret");
    expect(passwordCookie).toContain("page_session=");
  });

  test("persists room state across an API restart and cascades page deletion", async () => {
    const agentId = await registerAgent();
    const pageId = await createPage(agentId, "public");
    const client = await openSocket({ Origin: baseUrl }, pageSocketUrl(pageId));
    const joined = await join(client, 1, "persistent", `task:page:${pageId}`);
    client.send({
      id: 2,
      op: "change",
      name: "persistent",
      schemaVersion: 1,
      generation: joined.room.generation,
      operations: [{ type: "set", path: ["survivesRestart"], value: true }],
    });
    await client.next((frame) => frame.type === "result" && frame.id === 2);
    await Bun.sleep(1_200);
    await closeSocket(client);

    server.kill("SIGTERM");
    await server.exited;
    server = Bun.spawn(["bun", "src/http.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        PORT: new URL(baseUrl).port,
        API_KEY: apiKey,
        AGENT_SWARM_API_KEY: apiKey,
        DATABASE_PATH: dbPath,
        PAGE_SESSION_SECRET: pageSecret,
        MCP_BASE_URL: baseUrl,
        NODE_ENV: "test",
        CAPABILITIES: "core,task-pool,messaging,profiles,services,scheduling,memory,pages",
        SLACK_DISABLE: "true",
        GITHUB_DISABLE: "true",
        LINEAR_DISABLE: "true",
        JIRA_DISABLE: "true",
        AGENTMAIL_DISABLE: "true",
        OAUTH_KEEPALIVE_DISABLE: "true",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForServer(`${baseUrl}/health`);

    const afterRestart = await openSocket({ Origin: baseUrl }, pageSocketUrl(pageId));
    try {
      const restored = await join(afterRestart, 3, "persistent", `task:page:${pageId}`);
      expect(restored.room.state).toEqual({ survivesRestart: true });
    } finally {
      await closeSocket(afterRestart);
    }

    const deletionPage = await createPage(agentId, "public");
    const deletionClient = await openSocket({ Origin: baseUrl }, pageSocketUrl(deletionPage));
    try {
      await join(deletionClient, 4, "cascade", `task:page:${deletionPage}`);
      const deleted = await api("DELETE", `/api/pages/${deletionPage}`, { agentId });
      expect(deleted.status).toBe(204);
      await deletionClient.next((frame) => frame.type === "deleted" && frame.name === "cascade");
      expect(await socketAccepted({ Origin: baseUrl }, pageSocketUrl(deletionPage))).toBe(false);
    } finally {
      await closeSocket(deletionClient);
    }
  });

  test("attributes signed user page sessions to the user and presence peers", async () => {
    const agentId = await registerAgent();
    const viewer = await createUserToken("Realtime Viewer");
    const pageId = await createPage(agentId, "authed");
    const userCookie = await launchPageAsUser(pageId, viewer.token);
    const guestCookie = await launchPage(pageId, agentId);
    const user = await openSocket({ Origin: baseUrl, Cookie: userCookie }, pageSocketUrl(pageId));
    const guest = await openSocket({ Origin: baseUrl, Cookie: guestCookie }, pageSocketUrl(pageId));
    try {
      const userJoined = await join(user, 1, "identity");
      expect(userJoined.me).toMatchObject({
        userId: viewer.id,
        name: "Realtime Viewer",
        kind: "user",
      });

      await join(guest, 2, "identity");
      const presence = await user.next(
        (frame) =>
          frame.type === "presence" &&
          frame.name === "identity" &&
          Array.isArray(frame.peers) &&
          frame.peers.some((peer: Frame) => peer.userId === viewer.id),
      );
      const viewerPeer = (presence.peers as Frame[]).find((peer) => peer.userId === viewer.id);
      expect(viewerPeer).toMatchObject({
        userId: viewer.id,
        name: "Realtime Viewer",
        kind: "user",
      });
    } finally {
      await closeSocket(user);
      await closeSocket(guest);
    }
  });

  test("keeps agent bearer identity for explicit room namespaces", async () => {
    const agentId = await registerAgent();
    const client = await openSocket({
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
      Origin: baseUrl,
    });
    try {
      const result = await join(client, 1, "agent-room", `task:agent:${agentId}`);
      expect(result.me.userId).toBe(agentId);
      expect(result.me.kind).toBe("agent");
    } finally {
      await closeSocket(client);
    }
  });
});
